import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { listControlPlaneCustomers, requireControlPlaneAccess } from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { ControlPlaneLanguageSwitcher } from "./ControlPlaneLanguageSwitcher";

export const dynamic = "force-dynamic";

type ControlPlaneCustomer = Awaited<ReturnType<typeof listControlPlaneCustomers>>[number];

const CONTROL_PLANE_SECTION_IDS = [
  "fleet",
  "customers",
  "context",
  "ai-governance",
  "integrations",
  "releases",
  "support",
  "audit",
  "mcp",
] as const;

type ControlPlaneT = Awaited<ReturnType<typeof getTranslations>>;

function statusTone(status?: string | null) {
  if (status === "ok" || status === "active" || status === "connected") return "var(--green-11)";
  if (status === "attention" || status === "degraded" || status === "provisioning" || status === "configured" || status === "pending") return "var(--orange-11)";
  if (status === "down" || status === "suspended" || status === "failed" || status === "FAILED") return "var(--red-11)";
  return "var(--gray-11)";
}

function statusLabel(t: ControlPlaneT, status?: string | null) {
  const normalized = status?.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const key = normalized && [
    "active",
    "attention",
    "connected",
    "configured",
    "degraded",
    "disabled",
    "down",
    "failed",
    "not_configured",
    "ok",
    "pending",
    "provisioning",
    "ready",
    "suspended",
    "unknown",
  ].includes(normalized)
    ? normalized
    : "unknown";

  return normalized && key !== "unknown" ? t(`status.${key}` as any) : (status ? status.replace(/_/g, " ") : t("status.unknown"));
}

function instanceReadiness(customer: ControlPlaneCustomer, t: ControlPlaneT) {
  const issues = [
    !customer.region ? t("readiness.regionMissing") : null,
    !customer.dataResidency ? t("readiness.residencyMissing") : null,
    !customer.releaseImageTag && !customer.releaseVersion ? t("readiness.releaseUnknown") : null,
    !customer.lastHealthCheck ? t("readiness.noHealthProbe") : null,
    customer.lastHealthStatus && customer.lastHealthStatus !== "ok" ? t("readiness.runtimeStatus", { status: statusLabel(t, customer.lastHealthStatus) }) : null,
    !customer.hasSupportCredential ? t("readiness.supportConnectorMissing") : null,
    customer.supportConnectorStatus === "degraded" ? t("readiness.supportConnectorDegraded") : null,
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
  const t = await getTranslations("controlPlane");
  const totals = customers.reduce((summary, customer) => ({
    active: summary.active + (customer.provisioningStatus === "active" ? 1 : 0),
    attention: summary.attention + (instanceReadiness(customer, t).status === "attention" ? 1 : 0),
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
        <strong>{t("title")}</strong>
        {CONTROL_PLANE_SECTION_IDS.map((id) => (
          <a key={id} className="ws-nav-link" href={`#${id}`}>
            <span className="ws-nav-icon">◇</span>
            {t(`sections.${id}.label` as any)}
          </a>
        ))}
        <ControlPlaneLanguageSwitcher />
      </aside>

      <div className="control-plane-content stack">
        <header className="page-header">
          <div>
            <p className="muted" style={{ textTransform: "uppercase", fontSize: 12 }}>{t("eyebrow")}</p>
            <h1 className="title-lg" style={{ margin: 0 }}>{t("title")}</h1>
            <p className="muted" style={{ maxWidth: 720 }}>
              {t("description")}
            </p>
          </div>
        </header>

        <section id="fleet" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
          {[
            [t("fleetCards.customers.label"), customers.length, t("fleetCards.customers.detail")],
            [t("fleetCards.active.label"), totals.active, t("fleetCards.active.detail")],
            [t("fleetCards.managed.label"), totals.managed, t("fleetCards.managed.detail")],
            [t("fleetCards.supportReady.label"), totals.supportReady, t("fleetCards.supportReady.detail")],
            [t("fleetCards.needsAttention.label"), totals.attention + totals.failedOperations, t("fleetCards.needsAttention.detail")],
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
              <h2 style={{ margin: 0 }}>{t("customers.title")}</h2>
              <p className="muted" style={{ margin: "4px 0 0" }}>{t("customers.description")}</p>
            </div>
            <form method="get" style={{ display: "flex", gap: 8 }}>
              <input name="q" defaultValue={query} placeholder={t("customers.searchPlaceholder")} style={{ minWidth: 260 }} />
              <button type="submit" className="button secondary small">{t("customers.searchButton")}</button>
            </form>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color)" }}>
                  <th style={{ padding: 14 }}>{t("customers.columns.customer")}</th>
                  <th style={{ padding: 14 }}>{t("customers.columns.readiness")}</th>
                  <th style={{ padding: 14 }}>{t("customers.columns.workspace")}</th>
                  <th style={{ padding: 14 }}>{t("customers.columns.region")}</th>
                  <th style={{ padding: 14 }}>{t("customers.columns.release")}</th>
                  <th style={{ padding: 14 }}>{t("customers.columns.runtime")}</th>
                  <th style={{ padding: 14 }}>{t("customers.columns.support")}</th>
                  <th style={{ padding: 14 }}>{t("customers.columns.lastCheck")}</th>
                  <th style={{ padding: 14 }}>{t("customers.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((customer) => {
                  const readiness = instanceReadiness(customer, t);
                  return (
                    <tr key={customer.id} style={{ borderBottom: "1px solid var(--border-color)" }}>
                      <td style={{ padding: 14 }}>
                        <strong>{customer.label}</strong>
                        <div className="muted">{customer.customerSlug || customer.url}</div>
                      </td>
                      <td style={{ padding: 14 }}>
                        <span style={{ color: statusTone(readiness.status), fontWeight: 700 }}>{statusLabel(t, readiness.status)}</span>
                        {readiness.issues.length > 0 && <div className="muted">{readiness.issues.slice(0, 2).join(", ")}</div>}
                      </td>
                      <td style={{ padding: 14 }}>
                        {customer.managedWorkspace ? (
                          <>
                            <strong>{customer.managedWorkspace.name}</strong>
                            <div className="muted">{customer.managedWorkspace.slug}</div>
                          </>
                        ) : (
                          <span className="muted">{t("status.remoteOnly")}</span>
                        )}
                      </td>
                      <td style={{ padding: 14 }}>{customer.region || t("status.notSet")}</td>
                      <td style={{ padding: 14 }}>{customer.releaseImageTag || customer.releaseVersion || t("status.unknown")}</td>
                      <td style={{ padding: 14 }}>
                        <span style={{ color: statusTone(customer.lastHealthStatus), fontWeight: 600 }}>
                          {statusLabel(t, customer.lastHealthStatus || customer.provisioningStatus || "unknown")}
                        </span>
                        {customer.lastHealthError && <div className="muted">{customer.lastHealthError}</div>}
                      </td>
                      <td style={{ padding: 14 }}>
                        <span style={{ color: statusTone(customer.supportConnectorStatus), fontWeight: 600 }}>
                          {statusLabel(t, customer.supportConnectorStatus)}
                        </span>
                        <div className="muted">{customer.supportOwnerEmail || t("customers.noOwner")}</div>
                      </td>
                      <td style={{ padding: 14 }}>
                        {customer.supportLastSyncAt
                          ? format.dateTime(customer.supportLastSyncAt, { dateStyle: "medium", timeStyle: "short" })
                          : customer.lastHealthCheck
                            ? format.dateTime(customer.lastHealthCheck, { dateStyle: "medium", timeStyle: "short" })
                            : t("status.never")}
                      </td>
                      <td style={{ padding: 14 }}>
                        <Link className="button secondary small" href={`/control-plane/customers/${customer.id}`}>
                          {t("customers.open")}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {filteredCustomers.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 32, textAlign: "center" }} className="muted">
                      {t("customers.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          {CONTROL_PLANE_SECTION_IDS.slice(2).map((id) => (
            <div id={id} className="panel stack" key={id} style={{ padding: 18, gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{t(`sections.${id}.label` as any)}</h2>
              <p className="muted" style={{ margin: 0 }}>{t(`sections.${id}.detail` as any)}</p>
              <div className="muted" style={{ fontSize: 12 }}>
                {id === "support"
                  ? t("sections.support.recentOperations", { count: recentOperations.length })
                  : t("sections.detailPageNote")}
              </div>
            </div>
          ))}
        </section>

        <section className="panel stack" style={{ padding: 20, gap: 14 }}>
          <div>
            <h2 style={{ margin: 0 }}>{t("operationHistory.title")}</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>{t("operationHistory.description")}</p>
          </div>
          {recentOperations.map(({ customer, operation }) => (
            <div className="item" key={operation.id}>
              <div className="row">
                <div>
                  <strong>{operation.action}</strong>
                  <div className="muted">{t("operationHistory.customerReason", { customer: customer.label, reason: operation.reason })}</div>
                </div>
                <span style={{ color: statusTone(operation.status), fontWeight: 700 }}>{statusLabel(t, operation.status)}</span>
              </div>
              <div className="muted">{format.dateTime(operation.createdAt, { dateStyle: "medium", timeStyle: "short" })}</div>
            </div>
          ))}
          {recentOperations.length === 0 && <p className="muted">{t("operationHistory.empty")}</p>}
        </section>
      </div>
    </main>
  );
}
