import { randomUUID } from "node:crypto";
import {
  canManagePracticeFinanceProjects,
  getNativePracticeProjectDetail,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { Prisma } from "@prisma/client";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import {
  createNativePracticeExpenseAction,
  createNativePracticeTimeEntryAction,
} from "../../actions";

export const dynamic = "force-dynamic";

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      currency,
      style: "currency",
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toLocaleString("en-US", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    })}`;
  }
}

function rateDerivedCents(hours: { toString(): string }, rateCents: number): number {
  return new Prisma.Decimal(hours.toString()).mul(rateCents).toDecimalPlaces(0).toNumber();
}

function timeBillAmount(entry: {
  billAmountCents: number | null;
  billCurrency: string | null;
  currency: string;
  functionalCurrency: string | null;
  hours: { toString(): string };
  billRateCents: number;
}): { cents: number; currency: string } {
  if (entry.billAmountCents != null) {
    return { cents: entry.billAmountCents, currency: entry.functionalCurrency ?? entry.billCurrency ?? entry.currency };
  }
  return { cents: rateDerivedCents(entry.hours, entry.billRateCents), currency: entry.billCurrency ?? entry.currency };
}

function timeCostAmount(entry: {
  costAmountCents: number | null;
  costCurrency: string | null;
  currency: string;
  functionalCurrency: string | null;
  hours: { toString(): string };
  costRateCents: number;
}): { cents: number; currency: string } {
  if (entry.costAmountCents != null) {
    return { cents: entry.costAmountCents, currency: entry.functionalCurrency ?? entry.costCurrency ?? entry.currency };
  }
  return { cents: rateDerivedCents(entry.hours, entry.costRateCents), currency: entry.costCurrency ?? entry.currency };
}

function marginLabel(bps: number | null): string {
  return bps == null ? "-" : `${(bps / 100).toFixed(1)}%`;
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function statusLabel(value: string): string {
  return value.toLowerCase().replace("_", " ");
}

const metricStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 8,
  flex: "1 1 150px",
  minWidth: 130,
  padding: "12px 14px",
};

const labelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
};

export default async function PracticeProjectDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceFeature(workspaceId, "FINANCE");
  await requireWorkspaceFeature(workspaceId, "PRACTICE_PROJECTS");
  const [membership, workspace, detail] = await Promise.all([
    requireWorkspaceMembership({ actor, workspaceId }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    getNativePracticeProjectDetail(actor, workspaceId, projectId),
  ]);
  const readOnlyDemo = workspace?.slug === "jnj-demo";
  const canManageProject = !readOnlyDemo && await canManagePracticeFinanceProjects(actor, workspaceId, {
    resolvedMembership: membership,
  });
  const { project, health } = detail;
  const timeIdempotencyKey = `manual-time-${project.id}-${randomUUID()}`;
  const expenseIdempotencyKey = `manual-expense-${project.id}-${randomUUID()}`;

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-project-detail">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <div style={{ alignItems: "flex-start", display: "flex", gap: 16, justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance`}>Back to Practice Ledger</a>
            <h1 style={{ marginTop: 12 }}>{project.name}</h1>
            <div className="nr-masthead-meta">
              <span>{project.code}</span>
              <span>{project.clientName}</span>
              <span>{statusLabel(project.status)}</span>
            </div>
          </div>
          {project.crmAccountId && (
            <a className="link-button secondary" href={`/workspaces/${workspaceId}/leads/accounts/${project.crmAccountId}`}>
              Open CRM account
            </a>
          )}
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={metricStyle}>
          <div style={labelStyle}>Budget</div>
          <div style={{ fontSize: 24, marginTop: 6 }}>{money(health.budgetCents, health.currency)}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Used</div>
          <div style={{ fontSize: 24, marginTop: 6 }}>{money(health.usedBudgetCents, health.currency)}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Remaining</div>
          <div style={{ fontSize: 24, marginTop: 6 }}>{money(health.remainingBudgetCents, health.currency)}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Direct cost</div>
          <div style={{ fontSize: 24, marginTop: 6 }}>{money(health.directCostCents, health.currency)}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Gross margin</div>
          <div style={{ fontSize: 24, marginTop: 6 }}>{marginLabel(health.grossMarginBps)}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Runway</div>
          <div style={{ fontSize: 24, marginTop: 6 }}>
            {health.weeksToBudgetExhaustion == null ? "-" : `${health.weeksToBudgetExhaustion.toFixed(1)}w`}
          </div>
        </div>
      </div>

      <div className="nr-item" style={{ padding: 16 }}>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <div>
            <div style={labelStyle}>Native client</div>
            <div>{project.client?.name ?? project.clientName}</div>
          </div>
          <div>
            <div style={labelStyle}>Currency</div>
            <div>{project.currency}</div>
          </div>
          <div>
            <div style={labelStyle}>Service budget</div>
            <div>{money(project.serviceBudgetCents, project.currency)}</div>
          </div>
          <div>
            <div style={labelStyle}>Expense budget</div>
            <div>{money(project.expenseBudgetCents, project.currency)}</div>
          </div>
          <div>
            <div style={labelStyle}>Purchase orders</div>
            <div>{project._count.purchaseOrders}</div>
          </div>
          <div>
            <div style={labelStyle}>Assignments</div>
            <div>{project._count.assignments}</div>
          </div>
        </div>
      </div>

      {canManageProject && (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          <form action={createNativePracticeTimeEntryAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="idempotencyKey" value={timeIdempotencyKey} />
            <strong>Record time</strong>
            <div style={formGridStyle}>
              <label>Consultant<input name="consultantName" required /></label>
              <label>Email<input name="consultantEmail" type="email" /></label>
            </div>
            <div style={formGridStyle}>
              <label>Date<input name="workedOn" type="date" required /></label>
              <label>Hours<input name="hours" type="number" min="0.01" step="0.01" required /></label>
              <label>Assignment<input name="assignmentType" defaultValue="CONSULTING" required /></label>
            </div>
            <div style={formGridStyle}>
              <label>Bill rate<input name="billRate" type="number" min="0" step="0.01" defaultValue="0.00" /></label>
              <label>Cost rate<input name="costRate" type="number" min="0" step="0.01" defaultValue="0.00" /></label>
            </div>
            <button type="submit" className="fin-action-btn">Submit time</button>
          </form>

          <form action={createNativePracticeExpenseAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="idempotencyKey" value={expenseIdempotencyKey} />
            <strong>Record expense</strong>
            <div style={formGridStyle}>
              <label>Date<input name="spentOn" type="date" required /></label>
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Currency<input name="currency" defaultValue={project.currency} required /></label>
            </div>
            <div style={formGridStyle}>
              <label>Vendor<input name="vendor" /></label>
              <label>Category<input name="category" defaultValue="Client expense" required /></label>
            </div>
            <div style={formGridStyle}>
              <label>Consultant<input name="consultantName" /></label>
              <label>Email<input name="consultantEmail" type="email" /></label>
            </div>
            <label>Business purpose<input name="businessPurpose" required /></label>
            <label style={{ alignItems: "center", display: "flex", flexDirection: "row", gap: 8 }}>
              <input name="billable" type="checkbox" defaultChecked />
              Billable to client
            </label>
            <button type="submit" className="fin-action-btn">Submit expense</button>
          </form>
        </div>
      )}

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ borderBottom: "1px solid var(--line)", padding: "12px 16px" }}>
          <strong>Recent time</strong>
        </div>
        {detail.recentTimeEntries.length === 0 ? (
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No time has been submitted for this project.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Consultant</th>
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
                    <td>
                      <div>{entry.consultant.name}</div>
                      {entry.consultant.email && <div className="nr-item-meta" style={{ fontSize: 11 }}>{entry.consultant.email}</div>}
                    </td>
                    <td style={{ textAlign: "right" }}>{entry.hours.toString()}</td>
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
          <p className="nr-item-meta" style={{ margin: 0, padding: 16 }}>No expenses have been submitted for this project.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Purpose</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th>Billable</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.recentExpenses.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.spentOn)}</td>
                    <td>
                      <div>{entry.category}</div>
                      {entry.vendor && <div className="nr-item-meta" style={{ fontSize: 11 }}>{entry.vendor}</div>}
                    </td>
                    <td>{entry.businessPurpose}</td>
                    <td style={{ textAlign: "right" }}>{money(entry.amountFunctionalCents ?? entry.amountCents, entry.functionalCurrency ?? entry.currency)}</td>
                    <td>{entry.billable ? "Yes" : "No"}</td>
                    <td>{statusLabel(entry.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
