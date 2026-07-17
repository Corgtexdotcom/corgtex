import { getNativePracticeFinanceDashboard, type NativePracticeFinanceSummary } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFeatureEnabled, requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { PracticeFinanceNav, PracticeMetric, marginLabel, wholeMoney } from "../components";

export const dynamic = "force-dynamic";

const exports = [
  { kind: "projects", label: "Projects" },
  { kind: "clients", label: "Clients" },
  { kind: "consultants", label: "Consultants" },
  { kind: "time", label: "Time entries" },
  { kind: "expenses", label: "Expenses" },
];

function summaryMoney(summary: NativePracticeFinanceSummary, cents: number): string {
  if (summary.currency == null && summary.activeProjects > 0) return "Mixed";
  return wholeMoney(cents, summary.currency ?? "USD");
}

export default async function PracticeReportsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFeature(workspaceId, "PRACTICE_PROJECTS");
  const [dashboard, slicingPieEnabled] = await Promise.all([
    getNativePracticeFinanceDashboard(actor, workspaceId),
    isWorkspaceFeatureEnabled(workspaceId, "SLICING_PIE"),
  ]);

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-reports">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance`}>Back to Practice Ledger</a>
        <h1 style={{ marginTop: 12 }}>Reports</h1>
        <div className="nr-masthead-meta">
          <span>Native Practice Ledger rollups and CSV exports.</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav workspaceId={workspaceId} active="reports" slicingPieEnabled={slicingPieEnabled} />
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <PracticeMetric label="Active projects" value={dashboard.summary.activeProjects} />
        <PracticeMetric label="Budget" value={summaryMoney(dashboard.summary, dashboard.summary.budgetCents)} />
        <PracticeMetric label="Used" value={summaryMoney(dashboard.summary, dashboard.summary.usedCents)} />
        <PracticeMetric label="Remaining" value={summaryMoney(dashboard.summary, dashboard.summary.remainingCents)} />
        <PracticeMetric label="Margin" value={marginLabel(dashboard.summary.marginBps)} />
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>CSV exports</strong>
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", padding: 16 }}>
          {exports.map((item) => (
            <a
              key={item.kind}
              className="link-button secondary"
              href={`/api/workspaces/${workspaceId}/practice-ledger/exports/${item.kind}`}
            >
              Download {item.label}
            </a>
          ))}
        </div>
        <p className="nr-item-meta" style={{ borderTop: "1px solid var(--line)", margin: 0, padding: "12px 16px" }}>
          Exports are generated from native Corgtex Finance data and capped per file to keep requests bounded.
        </p>
      </div>
    </section>
  );
}
