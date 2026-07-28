import { getNativePracticeConsultantDetail } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { isWorkspaceFinanceCapabilityEnabled, requireWorkspaceFeature, requireWorkspaceFinanceCapability } from "@/lib/workspace-feature-flags";
import {
  PracticeFinanceNav,
  PracticeMetric,
  expenseAmount,
  formatDate,
  hoursLabel,
  marginLabel,
  money,
  statusLabel,
  timeBillAmount,
  timeCostAmount,
  wholeMoney,
} from "../../components";

export const dynamic = "force-dynamic";

function utilizationLabel(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

function consultantTotalsLabel(
  totals: Array<{ currency: string; billedCents: number; costCents: number; expenseCents: number }>,
  key: "billedCents" | "costCents" | "expenseCents",
): string {
  if (totals.length === 0) return "-";
  return totals.map((total) => wholeMoney(total[key], total.currency)).join(" / ");
}

export default async function PracticeConsultantDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; consultantId: string }>;
}) {
  const { workspaceId, consultantId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFinanceCapability(workspaceId, "projects");
  const [detail, slicingPieEnabled] = await Promise.all([
    getNativePracticeConsultantDetail(actor, workspaceId, consultantId),
    isWorkspaceFinanceCapabilityEnabled(workspaceId, "slicingPie"),
  ]);
  const { consultant, utilization } = detail;

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-consultant-detail">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance/consultants`}>Back to consultants</a>
        <h1 style={{ marginTop: 12 }}>{consultant.name}</h1>
        <div className="nr-masthead-meta">
          {consultant.email && <span>{consultant.email}</span>}
          <span>{consultant.active ? "active" : "inactive"}</span>
          <span>{consultant.homeCurrency}</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav workspaceId={workspaceId} active="consultants" slicingPieEnabled={slicingPieEnabled} />
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <PracticeMetric label="Utilization" value={utilizationLabel(utilization.utilizationBps)} />
        <PracticeMetric label="Avg weekly hours" value={utilization.averageWeeklyHours.toLocaleString("en-US")} />
        <PracticeMetric label="Recent hours" value={utilization.recentHours.toLocaleString("en-US")} />
        <PracticeMetric label="Billed" value={consultantTotalsLabel(utilization.financialTotals, "billedCents")} />
        <PracticeMetric label="Cost" value={consultantTotalsLabel(utilization.financialTotals, "costCents")} />
        <PracticeMetric label="Expenses" value={consultantTotalsLabel(utilization.financialTotals, "expenseCents")} />
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Projects</strong>
        </div>
        {detail.projectHealth.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No projects are linked to this consultant.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Budget</th>
                  <th style={{ textAlign: "right" }}>Used</th>
                  <th style={{ textAlign: "right" }}>Margin</th>
                </tr>
              </thead>
              <tbody>
                {detail.projectHealth.map((project) => (
                  <tr key={project.projectId}>
                    <td>
                      <a href={`/workspaces/${workspaceId}/finance/projects/${project.projectId}`}>{project.projectName}</a>
                      <div className="nr-item-meta" style={{ fontSize: 11 }}>{project.projectCode}</div>
                    </td>
                    <td>{project.clientName}</td>
                    <td>{statusLabel(project.status)}</td>
                    <td style={{ textAlign: "right" }}>{wholeMoney(project.budgetCents, project.currency)}</td>
                    <td style={{ textAlign: "right" }}>{wholeMoney(project.usedBudgetCents, project.currency)}</td>
                    <td style={{ textAlign: "right" }}>{marginLabel(project.grossMarginBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Recent time</strong>
        </div>
        {detail.recentTimeEntries.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No recent time entries are linked to this consultant.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Project</th>
                  <th style={{ textAlign: "right" }}>Hours</th>
                  <th style={{ textAlign: "right" }}>Bill amount</th>
                  <th style={{ textAlign: "right" }}>Cost amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.recentTimeEntries.map((entry) => {
                  const billAmount = timeBillAmount(entry);
                  const costAmount = timeCostAmount(entry);
                  return (
                    <tr key={entry.id}>
                      <td>{formatDate(entry.workedOn)}</td>
                      <td><a href={`/workspaces/${workspaceId}/finance/projects/${entry.project.id}`}>{entry.project.name}</a></td>
                      <td style={{ textAlign: "right" }}>{hoursLabel(entry.hours)}</td>
                      <td style={{ textAlign: "right" }}>{money(billAmount.cents, billAmount.currency)}</td>
                      <td style={{ textAlign: "right" }}>{money(costAmount.cents, costAmount.currency)}</td>
                      <td>{statusLabel(entry.status)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Recent expenses</strong>
        </div>
        {detail.recentExpenses.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No recent expenses are linked to this consultant.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Project</th>
                  <th>Category</th>
                  <th>Purpose</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.recentExpenses.map((entry) => {
                  const amount = expenseAmount(entry);
                  return (
                    <tr key={entry.id}>
                      <td>{formatDate(entry.spentOn)}</td>
                      <td><a href={`/workspaces/${workspaceId}/finance/projects/${entry.project.id}`}>{entry.project.name}</a></td>
                      <td>{entry.category}</td>
                      <td>{entry.businessPurpose}</td>
                      <td style={{ textAlign: "right" }}>{money(amount.cents, amount.currency)}</td>
                      <td>{statusLabel(entry.status)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
