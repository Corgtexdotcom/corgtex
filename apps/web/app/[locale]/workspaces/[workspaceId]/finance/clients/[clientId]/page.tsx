import { getNativePracticeClientDetail } from "@corgtex/domain";
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
  wholeMoney,
} from "../../components";

export const dynamic = "force-dynamic";

type CurrencyTotals = {
  budgetCents: number;
  remainingCents: number;
  usedCents: number;
};

function groupedProjectTotals(
  projects: Array<{ currency: string; budgetCents: number; remainingBudgetCents: number; usedBudgetCents: number }>,
): Map<string, CurrencyTotals> {
  const totals = new Map<string, CurrencyTotals>();
  for (const project of projects) {
    const currency = project.currency || "USD";
    const current = totals.get(currency) ?? { budgetCents: 0, remainingCents: 0, usedCents: 0 };
    current.budgetCents += project.budgetCents;
    current.usedCents += project.usedBudgetCents;
    current.remainingCents += project.remainingBudgetCents;
    totals.set(currency, current);
  }
  return totals;
}

function groupedMoney(totals: Map<string, CurrencyTotals>, key: keyof CurrencyTotals): string {
  if (totals.size === 0) return "-";
  return Array.from(totals.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, values]) => wholeMoney(values[key], currency))
    .join(" / ");
}

export default async function PracticeClientDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; clientId: string }>;
}) {
  const { workspaceId, clientId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFinanceCapability(workspaceId, "projects");
  const [detail, slicingPieEnabled] = await Promise.all([
    getNativePracticeClientDetail(actor, workspaceId, clientId),
    isWorkspaceFinanceCapabilityEnabled(workspaceId, "slicingPie"),
  ]);
  const { client } = detail;
  const totalsByCurrency = groupedProjectTotals(detail.projectHealth);
  const visibleProjectHealth = detail.projectHealth.slice(0, 100);

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-client-detail">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance/clients`}>Back to clients</a>
        <h1 style={{ marginTop: 12 }}>{client.name}</h1>
        <div className="nr-masthead-meta">
          <span>{client.code}</span>
          <span>{statusLabel(client.status)}</span>
          {client.crmAccount && <span>CRM: {client.crmAccount.name}</span>}
        </div>
        <div style={{ marginTop: 16 }}>
          <PracticeFinanceNav workspaceId={workspaceId} active="clients" slicingPieEnabled={slicingPieEnabled} />
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <PracticeMetric label="Projects" value={client._count.projects} />
        <PracticeMetric label="Budget" value={groupedMoney(totalsByCurrency, "budgetCents")} />
        <PracticeMetric label="Used" value={groupedMoney(totalsByCurrency, "usedCents")} />
        <PracticeMetric label="Remaining" value={groupedMoney(totalsByCurrency, "remainingCents")} />
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Projects</strong>
        </div>
        {detail.projectHealth.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No projects are linked to this native client yet.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Budget</th>
                  <th style={{ textAlign: "right" }}>Used</th>
                  <th style={{ textAlign: "right" }}>Remaining</th>
                  <th style={{ textAlign: "right" }}>Margin</th>
                </tr>
              </thead>
              <tbody>
                {visibleProjectHealth.map((project) => (
                  <tr key={project.projectId}>
                    <td>
                      <a href={`/workspaces/${workspaceId}/finance/projects/${project.projectId}`}>{project.projectName}</a>
                      <div className="nr-item-meta" style={{ fontSize: 11 }}>{project.projectCode}</div>
                    </td>
                    <td>{statusLabel(project.status)}</td>
                    <td style={{ textAlign: "right" }}>{wholeMoney(project.budgetCents, project.currency)}</td>
                    <td style={{ textAlign: "right" }}>{wholeMoney(project.usedBudgetCents, project.currency)}</td>
                    <td style={{ textAlign: "right" }}>{wholeMoney(project.remainingBudgetCents, project.currency)}</td>
                    <td style={{ textAlign: "right" }}>{marginLabel(project.grossMarginBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {detail.projectHealth.length > visibleProjectHealth.length && (
          <p className="nr-item-meta" style={{ borderTop: "1px solid var(--line)", margin: 0, padding: 12 }}>
            Showing first {visibleProjectHealth.length.toLocaleString("en-US")} of {detail.projectHealth.length.toLocaleString("en-US")} linked projects. Totals include all linked projects.
          </p>
        )}
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Recent time</strong>
        </div>
        {detail.recentTimeEntries.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No time entries are linked to this client.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Project</th>
                  <th>Consultant</th>
                  <th style={{ textAlign: "right" }}>Hours</th>
                  <th style={{ textAlign: "right" }}>Bill amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.recentTimeEntries.map((entry) => {
                  const billAmount = timeBillAmount(entry);
                  return (
                    <tr key={entry.id}>
                      <td>{formatDate(entry.workedOn)}</td>
                      <td><a href={`/workspaces/${workspaceId}/finance/projects/${entry.project.id}`}>{entry.project.name}</a></td>
                      <td>{entry.consultant.name}</td>
                      <td style={{ textAlign: "right" }}>{hoursLabel(entry.hours)}</td>
                      <td style={{ textAlign: "right" }}>{money(billAmount.cents, billAmount.currency)}</td>
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
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No expenses are linked to this client.</p>
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
