import {
  type PracticeContributionEntryWithContext,
  type PracticeAttentionItem,
  type NativePracticeFinanceSummary,
  type NativePracticeProjectHealth,
} from "@corgtex/domain";
import type { PracticeProject, PracticeProjectStatus } from "@prisma/client";
import {
  createPracticeContributionEntryAction,
  markPracticeContributionEntryPaidAction,
  updatePracticeProjectAction,
} from "./actions";

function money(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  try {
    return `${sign}${new Intl.NumberFormat("en-US", {
      currency,
      maximumFractionDigits: 0,
      style: "currency",
    }).format(Math.abs(Math.round(cents / 100)))}`;
  } catch {
    return `${sign}${currency} ${Math.abs(Math.round(cents / 100)).toLocaleString("en-US")}`;
  }
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function marginPct(bps: number | null): string {
  return bps == null ? "-" : `${(bps / 100).toFixed(1)}%`;
}

function weeksLabel(weeks: number | null): string {
  return weeks == null ? "No risk" : `${weeks.toFixed(1)}w`;
}

function usedRatio(health: NativePracticeProjectHealth): number {
  if (health.budgetCents <= 0) return 0;
  return Math.max(health.usedBudgetCents / health.budgetCents, 0);
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function statusLabel(status: PracticeProjectStatus): string {
  return status.toLowerCase().replace("_", " ");
}

function centsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function bpsInput(bps: number | null): string {
  return bps == null ? "" : (bps / 100).toFixed(1);
}

function entryKindLabel(entry: PracticeContributionEntryWithContext): string {
  return entry.type === "TIME" ? "Time" : "Expense";
}

function paymentLabel(entry: PracticeContributionEntryWithContext): string {
  if (entry.paymentChoice === "SLICING_PIE") return `Slicing Pie (${entry.sliceMultiplier}x)`;
  return entry.cashStatus === "PAID" ? "Cash paid" : "Cash requested";
}

const metricStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 8,
  flex: "1 1 160px",
  minWidth: 140,
  padding: "14px 16px",
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
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
};

function ProjectFields({ project }: { project?: PracticeProject }) {
  return (
    <>
      <div style={formGridStyle}>
        <label>
          Code
          <input name="code" defaultValue={project?.code ?? ""} required />
        </label>
        <label>
          Project
          <input name="name" defaultValue={project?.name ?? ""} required />
        </label>
        <label>
          Client
          <input name="clientName" defaultValue={project?.clientName ?? ""} required />
        </label>
        <label>
          Status
          <select name="status" defaultValue={project?.status ?? "ACTIVE"}>
            <option value="ACTIVE">Active</option>
            <option value="ON_HOLD">On hold</option>
            <option value="CLOSED">Closed</option>
          </select>
        </label>
      </div>

      <div style={formGridStyle}>
        <label>
          PO value
          <input name="poValue" type="number" step="0.01" min="0" defaultValue={project ? centsInput(project.poValueCents) : ""} />
        </label>
        <label>
          Service budget
          <input name="serviceBudget" type="number" step="0.01" min="0" defaultValue={project ? centsInput(project.serviceBudgetCents) : ""} />
        </label>
        <label>
          Expense budget
          <input name="expenseBudget" type="number" step="0.01" min="0" defaultValue={project ? centsInput(project.expenseBudgetCents) : ""} />
        </label>
        <label>
          Target margin %
          <input name="targetMargin" type="number" step="0.1" min="0" max="100" defaultValue={project ? bpsInput(project.targetMarginBps) : ""} />
        </label>
      </div>
    </>
  );
}

function ProjectEdit({ workspaceId, project }: { workspaceId: string; project: PracticeProject }) {
  return (
    <details style={{ display: "inline-block", position: "relative" }}>
      <summary className="fin-action-btn nr-hide-marker" style={{ cursor: "pointer" }}>
        Edit
      </summary>
      <div className="fin-dropdown" style={{ padding: 16, right: 0, width: 620 }}>
        <form action={updatePracticeProjectAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={project.id} />
          <ProjectFields project={project} />
          <button type="submit" className="fin-action-btn">Save</button>
        </form>
      </div>
    </details>
  );
}

function ProjectSelect({ projects }: { projects: PracticeProject[] }) {
  return (
    <select name="projectId" required defaultValue={projects[0]?.id ?? ""}>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>{project.code} - {project.name}</option>
      ))}
    </select>
  );
}

function ContributionForms({
  workspaceId,
  projects,
}: {
  workspaceId: string;
  projects: PracticeProject[];
}) {
  const disabled = projects.length === 0;
  return (
    <div className="nr-item" style={{ padding: 0 }}>
      <div style={{ alignItems: "center", borderBottom: "1px solid var(--line)", display: "flex", gap: 12, justifyContent: "space-between", padding: "12px 16px" }}>
        <strong>Contributions</strong>
        <a className="link-button small" href={`/workspaces/${workspaceId}/finance/slicing-pie`}>Slicing Pie</a>
      </div>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", padding: 16 }}>
        <form action={createPracticeContributionEntryAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="type" value="TIME" />
          <strong>Time</strong>
          <label>Project<ProjectSelect projects={projects} /></label>
          <div style={formGridStyle}>
            <label>Date<input name="occurredAt" type="date" required /></label>
            <label>Hours<input name="hours" type="number" min="0.1" step="0.1" required /></label>
            <label>Rate<input name="rate" type="number" min="0.01" step="0.01" required /></label>
          </div>
          <label>Description<input name="description" required /></label>
          <label>Payment
            <select name="paymentChoice" defaultValue="SLICING_PIE">
              <option value="SLICING_PIE">Slicing Pie</option>
              <option value="CASH">Cash</option>
            </select>
          </label>
          <button type="submit" className="fin-action-btn" disabled={disabled}>Record time</button>
        </form>
        <form action={createPracticeContributionEntryAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="type" value="EXPENSE" />
          <strong>Expense</strong>
          <label>Project<ProjectSelect projects={projects} /></label>
          <div style={formGridStyle}>
            <label>Date<input name="occurredAt" type="date" required /></label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Currency<input name="currency" defaultValue="USD" required /></label>
          </div>
          <label>Description<input name="description" required /></label>
          <label>Receipt URL<input name="receiptUrl" type="url" /></label>
          <label>Payment
            <select name="paymentChoice" defaultValue="SLICING_PIE">
              <option value="SLICING_PIE">Slicing Pie</option>
              <option value="CASH">Cash</option>
            </select>
          </label>
          <button type="submit" className="fin-action-btn" disabled={disabled}>Record expense</button>
        </form>
      </div>
      {disabled && <p className="nr-item-meta" style={{ margin: 0, padding: "0 16px 16px" }}>Create a project before recording contributions.</p>}
    </div>
  );
}

function RequestedPayables({
  workspaceId,
  entries,
  nextCursor,
  canMarkPaid,
}: {
  workspaceId: string;
  entries: PracticeContributionEntryWithContext[];
  nextCursor: string | null;
  canMarkPaid: boolean;
}) {
  if (entries.length === 0 && !nextCursor) return null;

  return (
    <div className="nr-item" style={{ padding: 0 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
        <strong>Requested cash payables</strong>
      </div>
      {entries.length === 0 ? (
        <p className="nr-item-meta" style={{ padding: 16, margin: 0 }}>No requested cash payables on this page.</p>
      ) : (
        <div className="nr-table-wrap">
          <table className="nr-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Contributor</th>
                <th>Project</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>Value</th>
                {canMarkPaid && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDate(entry.occurredAt)}</td>
                  <td>{entry.contributor.displayName || entry.contributor.email}</td>
                  <td>
                    <div>{entry.project.name}</div>
                    <div className="nr-item-meta" style={{ fontSize: 11 }}>{entry.project.code}</div>
                  </td>
                  <td>{entryKindLabel(entry)}</td>
                  <td style={{ textAlign: "right" }}>{money(entry.amountCents)}</td>
                  {canMarkPaid && (
                    <td>
                      <form action={markPracticeContributionEntryPaidAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="entryId" value={entry.id} />
                        <button type="submit" className="small">Mark paid</button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <div style={{ borderTop: "1px solid var(--line)", padding: 12 }}>
          <a className="link-button small secondary" href={`/workspaces/${workspaceId}/finance?payablesCursor=${encodeURIComponent(nextCursor)}`}>
            Next payables
          </a>
        </div>
      )}
    </div>
  );
}

export function PracticeFinanceDashboard({
  workspaceId,
  canManageProjects,
  practiceProjectsEnabled,
  canRecordContributions,
  canMarkContributionPaid,
  slicingPieEnabled,
  summary,
  attention,
  projectHealth,
  projects,
  contributionEntries,
  requestedPayables,
  requestedPayablesNextCursor,
}: {
  workspaceId: string;
  canManageProjects: boolean;
  practiceProjectsEnabled: boolean;
  canRecordContributions: boolean;
  canMarkContributionPaid: boolean;
  slicingPieEnabled: boolean;
  summary: NativePracticeFinanceSummary;
  attention: PracticeAttentionItem[];
  projectHealth: NativePracticeProjectHealth[];
  projects: PracticeProject[];
  contributionEntries: PracticeContributionEntryWithContext[];
  requestedPayables: PracticeContributionEntryWithContext[];
  requestedPayablesNextCursor: string | null;
}) {
  const projectById = new Map(projects.map((project) => [project.id, project]));

  return (
    <section className="stack" style={{ gap: 20 }} data-finance-surface="practice-dashboard">
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <div style={{ alignItems: "flex-start", display: "flex", gap: 16, justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <h1>Practice Ledger</h1>
            <div className="nr-masthead-meta">
              <span>Project margin, budget burn, client portfolio, and alerts for the active practice.</span>
            </div>
          </div>
          {slicingPieEnabled && (
            <a className="link-button secondary" href={`/workspaces/${workspaceId}/finance/slicing-pie`}>Slicing Pie</a>
          )}
        </div>
      </header>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={metricStyle}>
          <div style={labelStyle}>Active projects</div>
          <div style={{ fontSize: 26, marginTop: 6 }}>{summary.activeProjects}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Budget</div>
          <div style={{ fontSize: 26, marginTop: 6 }}>{money(summary.budgetCents, summary.currency ?? "USD")}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Used</div>
          <div style={{ fontSize: 26, marginTop: 6 }}>{money(summary.usedCents, summary.currency ?? "USD")}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Remaining</div>
          <div style={{ fontSize: 26, marginTop: 6 }}>{money(summary.remainingCents, summary.currency ?? "USD")}</div>
        </div>
        <div style={metricStyle}>
          <div style={labelStyle}>Margin</div>
          <div style={{ fontSize: 26, marginTop: 6 }}>{marginPct(summary.marginBps)}</div>
        </div>
      </div>

      {slicingPieEnabled && (
        <>
          {canRecordContributions && <ContributionForms workspaceId={workspaceId} projects={projects} />}
          <RequestedPayables
            workspaceId={workspaceId}
            entries={requestedPayables}
            nextCursor={requestedPayablesNextCursor}
            canMarkPaid={canMarkContributionPaid}
          />
          <div className="nr-item" style={{ padding: 0 }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
              <strong>Recent contributions</strong>
            </div>
            {contributionEntries.length === 0 ? (
              <p className="nr-item-meta" style={{ padding: 16, margin: 0 }}>No time or expense contributions have been recorded.</p>
            ) : (
              <div className="nr-table-wrap">
                <table className="nr-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Contributor</th>
                      <th>Project</th>
                      <th>Type</th>
                      <th style={{ textAlign: "right" }}>Value</th>
                      <th>Payment</th>
                      <th style={{ textAlign: "right" }}>Slices</th>
                      {canMarkContributionPaid && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {contributionEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{formatDate(entry.occurredAt)}</td>
                        <td>{entry.contributor.displayName || entry.contributor.email}</td>
                        <td>
                          <div>{entry.project.name}</div>
                          <div className="nr-item-meta" style={{ fontSize: 11 }}>{entry.project.code}</div>
                        </td>
                        <td>{entryKindLabel(entry)}</td>
                        <td style={{ textAlign: "right" }}>{money(entry.amountCents)}</td>
                        <td>{paymentLabel(entry)}</td>
                        <td style={{ textAlign: "right" }}>{entry.slices.toLocaleString("en-US")}</td>
                        {canMarkContributionPaid && (
                          <td>
                            {entry.paymentChoice === "CASH" && entry.cashStatus === "REQUESTED" ? (
                              <form action={markPracticeContributionEntryPaidAction}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="entryId" value={entry.id} />
                                <button type="submit" className="small">Mark paid</button>
                              </form>
                            ) : (
                              <span className="nr-item-meta">-</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
          <strong>Attention</strong>
        </div>
        {attention.length === 0 ? (
          <p className="nr-item-meta" style={{ padding: 16, margin: 0 }}>No projects need attention.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Issue</th>
                  <th>Weeks</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {attention.map((item, index) => (
                  <tr key={`${item.projectId}-${item.issue}-${index}`}>
                    <td>
                      {practiceProjectsEnabled ? (
                        <a href={`/workspaces/${workspaceId}/finance/projects/${item.projectId}`}>{item.projectName}</a>
                      ) : (
                        item.projectName
                      )}
                    </td>
                    <td>{item.issue}</td>
                    <td>{item.weeks == null ? "-" : item.weeks.toFixed(1)}</td>
                    <td className="nr-item-meta">{item.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="nr-item" style={{ padding: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
          <strong>Projects</strong>
        </div>
        {projectHealth.length === 0 ? (
          <div style={{ padding: 24 }}>
            <strong style={{ display: "block", marginBottom: 6 }}>No projects yet</strong>
            <p className="nr-item-meta" style={{ margin: 0 }}>
              Create a project to start tracking budget, burn, and margin.
            </p>
          </div>
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
                  <th style={{ textAlign: "right" }}>Remaining</th>
                  <th style={{ textAlign: "right" }}>Used %</th>
                  <th style={{ textAlign: "right" }}>Margin</th>
                  <th style={{ textAlign: "right" }}>Runway</th>
                  {canManageProjects && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {projectHealth.map((health) => {
                  const project = projectById.get(health.projectId);
                  return (
                  <tr key={health.projectId}>
                    <td>
                      <div>
                        {practiceProjectsEnabled ? (
                          <a href={`/workspaces/${workspaceId}/finance/projects/${health.projectId}`}>{health.projectName}</a>
                        ) : (
                          health.projectName
                        )}
                      </div>
                      <div className="nr-item-meta" style={{ fontSize: 11 }}>{health.projectCode}</div>
                    </td>
                    <td>{health.clientName}</td>
                    <td>{statusLabel(health.status)}</td>
                    <td style={{ textAlign: "right" }}>{money(health.budgetCents, health.currency)}</td>
                    <td style={{ textAlign: "right" }}>{money(health.usedBudgetCents, health.currency)}</td>
                    <td style={{ textAlign: "right" }}>{money(health.remainingBudgetCents, health.currency)}</td>
                    <td style={{ textAlign: "right" }}>{pct(usedRatio(health))}</td>
                    <td style={{ textAlign: "right" }}>{marginPct(health.grossMarginBps)}</td>
                    <td style={{ textAlign: "right" }}>{weeksLabel(health.weeksToBudgetExhaustion)}</td>
                    {canManageProjects && (
                      <td>
                        {project ? <ProjectEdit workspaceId={workspaceId} project={project} /> : <span className="nr-item-meta">-</span>}
                      </td>
                    )}
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
